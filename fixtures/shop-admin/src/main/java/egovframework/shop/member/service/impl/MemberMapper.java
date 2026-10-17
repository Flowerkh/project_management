package egovframework.shop.member.service.impl;

import java.util.List;
import egovframework.rte.psl.dataaccess.mapper.Mapper;
import egovframework.shop.member.service.MemberVO;

@Mapper("membermapper")
public interface MemberMapper {
    Object selectMemberList(MemberVO vo) throws Exception;
    Object selectMember(MemberVO vo) throws Exception;
    Object selectMemberAddrList(MemberVO vo) throws Exception;
    Object updateMemberGrade(MemberVO vo) throws Exception;
    Object selectGradeList(MemberVO vo) throws Exception;
    Object updateGrade(MemberVO vo) throws Exception;
    Object selectDormantList(MemberVO vo) throws Exception;
}
